import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  preReconciliationVerificationStatus,
  strictVerificationStatus,
  targetUnverifiedStrictVerificationStatus,
  buildMigrationLedgerVerificationSql
} from '../scripts/generate-migration-ledger-verification-sql.mjs';
import {
  CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST,
  CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE,
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST,
  MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION,
  MIGRATION_LEDGER_ACL_PHASE_STRICT,
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST,
  buildMigrationLedgerRepairSql,
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = loadMigrationEntries(root);
const revision = '2ebadf8f029da9febcba24b8335fd1c0275be964';
const productionDatabaseName = 'postgres';
const productionDatabaseRole = 'postgres';
const verificationGeneratedComment =
  '-- Generated read-only staging schema verification';
const canonicalCatalogOutputGucStatements = [
  "set local timezone = 'UTC';",
  "set local datestyle = 'ISO, YMD';",
  "set local intervalstyle = 'postgres';",
  'set local extra_float_digits = 3;',
  "set local bytea_output = 'hex';",
  'set local quote_all_identifiers = off;',
  'set local standard_conforming_strings = on;'
];

const quoteSqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

function assertVerifierHasNoWriteOrApplicationCallSurface(sql, label) {
  assert.doesNotMatch(
    sql,
    /^\s*(?:insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|call|copy|vacuum|refresh|reindex|cluster)\b/im,
    `${label} contains a DDL/DML statement`
  );
  assert.doesNotMatch(
    sql,
    /\b(?:from|join|perform|call|select)\s+(?:only\s+)?public\.[a-z_][a-z0-9_]*\s*\(/i,
    `${label} invokes an application-schema routine`
  );
}

function assertVerifierPinsCanonicalCatalogOutputGucs(sql, label) {
  const beginIndex = sql.indexOf('begin isolation level repeatable read read only;');
  const guardIndex = sql.indexOf('do $ledger_guard$', beginIndex);
  let previousIndex = beginIndex;
  assert.ok(beginIndex >= 0 && guardIndex > beginIndex, `${label} must retain its guard envelope`);
  for (const setting of canonicalCatalogOutputGucStatements) {
    assert.equal(
      sql.split(setting).length - 1,
      1,
      `${label} must pin ${setting} exactly once`
    );
    const settingIndex = sql.indexOf(setting, beginIndex);
    assert.ok(
      previousIndex < settingIndex && settingIndex < guardIndex,
      `${label} must pin ${setting} before catalog evidence and hashing`
    );
    previousIndex = settingIndex;
  }
}

const verificationPsqlPreflight = [
  '\\set ON_ERROR_STOP 1',
  '\\set ON_ERROR_ROLLBACK off',
  '\\unset cnyos_verification_probe_xid',
  '\\unset cnyos_verification_existing_transaction',
  '\\unset cnyos_verification_server_identity_ok',
  '\\unset cnyos_verification_lock_released',
  '\\if :AUTOCOMMIT',
  '\\else',
  "\\warn 'CNYOS staging verification requires psql AUTOCOMMIT=on; rolling back and refusing execution'",
  'rollback;',
  'do $cnyos_verification_psql_autocommit_abort$',
  'begin',
  "  raise exception 'CNYOS_STAGING_VERIFICATION_PSQL_AUTOCOMMIT_REQUIRED';",
  'end',
  '$cnyos_verification_psql_autocommit_abort$;',
  '\\endif',
  'set search_path = pg_catalog, pg_temp, public;',
  'select (',
  "  pg_catalog.current_database() = 'postgres'",
  "  and session_user = 'postgres'",
  "  and current_user = 'postgres'",
  ') as cnyos_verification_server_identity_ok',
  '\\gset',
  '\\if :cnyos_verification_server_identity_ok',
  '\\else',
  "\\warn 'CNYOS staging verification requires server database/session_user/current_user postgres'",
  'do $cnyos_verification_psql_identity_abort$',
  'begin',
  "  raise exception 'CNYOS_STAGING_VERIFICATION_SERVER_IDENTITY_REFUSED';",
  'end',
  '$cnyos_verification_psql_identity_abort$;',
  '\\endif',
  'select pg_catalog.pg_current_xact_id()::text as cnyos_verification_probe_xid',
  '\\gset',
  '\\unset cnyos_verification_existing_transaction',
  "select (\n  pg_catalog.pg_current_xact_id()::text = :'cnyos_verification_probe_xid'\n) as cnyos_verification_existing_transaction",
  '\\gset',
  '\\if :cnyos_verification_existing_transaction',
  "\\warn 'CNYOS staging verification detected and rolled back an existing transaction; refusing execution'",
  'rollback;',
  'do $cnyos_verification_psql_transaction_abort$',
  'begin',
  "  raise exception 'CNYOS_STAGING_VERIFICATION_PSQL_EXISTING_TRANSACTION_REFUSED';",
  'end',
  '$cnyos_verification_psql_transaction_abort$;',
  '\\endif',
  '\\unset cnyos_verification_lock_unheld',
  '\\unset cnyos_verification_lock_acquired',
  'select not exists (',
  '  select 1',
  '  from pg_catalog.pg_locks',
  "  where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted",
  '    and classid::bigint=(202608302100::bigint >> 32)',
  '    and objid::bigint=(202608302100::bigint & 4294967295::bigint)',
  '    and objsubid=1',
  ') as cnyos_verification_lock_unheld',
  '\\gset',
  '\\if :cnyos_verification_lock_unheld',
  '\\else',
  "\\warn 'CNYOS staging verification requires the advisory key to be unheld by this session'",
  'do $cnyos_verification_lock_state_abort$',
  'begin',
  "  raise exception 'CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_ALREADY_HELD';",
  'end',
  '$cnyos_verification_lock_state_abort$;',
  '\\endif',
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_verification_lock_acquired',
  '\\gset',
  '\\if :cnyos_verification_lock_acquired',
  '\\else',
  "\\warn 'CNYOS staging verification advisory key is busy; refusing rather than waiting'",
  'do $cnyos_verification_lock_abort$',
  'begin',
  "  raise exception 'CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_UNAVAILABLE';",
  'end',
  '$cnyos_verification_lock_abort$;',
  '\\endif'
].join('\n') + '\n';

assert.equal(entries.length, 45, 'verification must bind to the current 45-file migration chain');

for (const configFile of [
  'config/tenant.cnyos-staging.json',
  'config/tenant.jitarsa-staging.json'
]) {
  const config = JSON.parse(fs.readFileSync(path.join(root, configFile), 'utf8'));
  const sql = buildMigrationLedgerVerificationSql({
    config,
    entries,
    sourceRevision: revision
  });

  assertVerifierHasNoWriteOrApplicationCallSurface(sql, `${configFile} strict verifier`);

  assert.ok(
    sql.startsWith(verificationPsqlPreflight),
    'verification must refuse psql AUTOCOMMIT=off and an existing outer transaction before locking'
  );
  assert.doesNotMatch(sql, /^\\q(?:uit)?(?:\s|$)/m);
  assert.match(sql, /CNYOS_STAGING_VERIFICATION_PSQL_AUTOCOMMIT_REQUIRED/);
  assert.match(sql, /CNYOS_STAGING_VERIFICATION_PSQL_EXISTING_TRANSACTION_REFUSED/);
  assert.match(sql, /CNYOS_STAGING_VERIFICATION_SERVER_IDENTITY_REFUSED/);
  assert.match(sql, /-- Generated read-only staging schema verification \(strict-post-remediation\)\./);
  assert.match(sql, /begin isolation level repeatable read read only;/);
  assertVerifierPinsCanonicalCatalogOutputGucs(sql, `${configFile} strict verifier`);
  assert.match(sql, /set local search_path = pg_catalog, pg_temp, public;/);
  assert.match(sql, /current_setting\('transaction_isolation'\) <> 'repeatable read'/);
  assert.match(sql, /perform pg_catalog\.pg_advisory_xact_lock\(202608302100::bigint\)/);
  assert.match(sql, /do \$ledger_guard\$/);
  assert.match(sql, /end\n\$ledger_guard\$;\n\\unset cnyos_verification_evidence\nselect \(/);
  assert.match(sql, /STAGING_CLINICAL_TREATMENT_SESSION_SEMANTIC_CONTRACT_INVALID/);
  assert.match(sql, /STAGING_CLINICAL_TREATMENT_SESSION_ACL_MISSING/);
  assert.match(sql, /STAGING_CLINICAL_TREATMENT_SESSION_RUNTIME_EXECUTE_INVALID/);
  assert.match(sql, /STAGING_CLINICAL_TREATMENT_SESSION_ACL_INVALID/);
  assert.ok(sql.includes(
    REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.procedureSignature
  ));
  assert.ok(sql.includes("from (values ('authenticated')) expected(expected_grantee)"));
  assert.ok(sql.includes(
    "from (values ('anon','false'),('authenticated','true'),('service_role','false')) expected("
  ));
  const verificationOwnLockPreconditionIndex = sql.indexOf(
    ') as cnyos_verification_lock_unheld'
  );
  const verificationSessionLockIndex = sql.indexOf(
    'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) ' +
      'as cnyos_verification_lock_acquired'
  );
  const verificationCommentIndex = sql.indexOf(verificationGeneratedComment);
  const verificationBeginIndex = sql.indexOf(
    'begin isolation level repeatable read read only;'
  );
  const verificationUnlockIndex = sql.indexOf(
    '\\unset cnyos_verification_lock_released',
    verificationBeginIndex
  );
  const verificationEvidenceCaptureIndex = sql.indexOf(
    ')::text as cnyos_verification_evidence',
    verificationBeginIndex
  );
  const verificationRollbackIndex = sql.indexOf(
    'rollback;',
    verificationEvidenceCaptureIndex
  );
  for (const requiredVerificationBoundary of [
    verificationOwnLockPreconditionIndex,
    verificationSessionLockIndex,
    verificationCommentIndex,
    verificationBeginIndex,
    verificationEvidenceCaptureIndex,
    verificationRollbackIndex,
    verificationUnlockIndex
  ]) assert.notEqual(requiredVerificationBoundary, -1);
  assert.doesNotMatch(sql, /pg_catalog\.pg_advisory_lock\(202608302100::bigint\)/);
  assert.match(sql, /CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_ALREADY_HELD/);
  assert.match(sql, /CNYOS_STAGING_VERIFICATION_ADVISORY_LOCK_UNAVAILABLE/);
  assert.equal(
    (sql.match(/\) as cnyos_verification_lock_(?:unheld|fully_released)/g) ?? []).length,
    2,
    'verification must reject a reentrant session lock and prove zero own-key holds after unlock'
  );
  assert.ok(
    verificationOwnLockPreconditionIndex < verificationSessionLockIndex &&
    verificationSessionLockIndex < verificationCommentIndex &&
    verificationCommentIndex < verificationBeginIndex &&
    verificationBeginIndex < verificationEvidenceCaptureIndex &&
    verificationEvidenceCaptureIndex < verificationRollbackIndex &&
    verificationRollbackIndex < verificationUnlockIndex,
    'verification evidence must be captured inside the locked read-only snapshot before rollback and unlock'
  );
  assert.match(
    sql,
    /v_observed_current_database text := pg_catalog\.current_database\(\);\n  v_observed_session_user text := session_user;\n  v_observed_current_user text := current_user;/
  );
  assert.match(
    sql,
    /if v_observed_current_database is distinct from 'postgres'\n     or v_observed_session_user is distinct from 'postgres'\n     or v_observed_current_user is distinct from 'postgres' then/
  );
  assert.doesNotMatch(sql, /raise notice/);
  const expectedStrictVerificationStatus =
    configFile === 'config/tenant.cnyos-staging.json'
      ? strictVerificationStatus
      : targetUnverifiedStrictVerificationStatus;
  assert.match(sql, new RegExp(`"status":"${expectedStrictVerificationStatus}"`));
  assert.doesNotMatch(sql, /SCHEMA_GUARD_PASSED/);
  assert.ok(sql.includes(`"expected_deployment_id":"${config.deploymentId}"`));
  assert.ok(sql.includes(`"expected_clinic_code":"${config.tenant.expectedClinicCode}"`));
  assert.ok(sql.includes(`"expected_clinic_id":"${config.tenant.expectedClinicId}"`));
  assert.ok(sql.includes(`"expected_database_origin":"${new URL(config.database.url).origin}"`));
  assert.ok(sql.includes(`"expected_current_database":"${productionDatabaseName}"`));
  assert.ok(sql.includes(`"expected_session_user":"${productionDatabaseRole}"`));
  assert.ok(sql.includes(`"expected_current_user":"${productionDatabaseRole}"`));
  assert.ok(sql.includes("'observed_system_identifier',(select system_identifier::text from pg_catalog.pg_control_system())"));
  assert.ok(sql.includes("'observed_current_database',pg_catalog.current_database()"));
  assert.ok(sql.includes("'observed_session_user',session_user"));
  assert.ok(sql.includes("'observed_current_user',current_user"));
  assert.ok(sql.includes("'observed_server_address',pg_catalog.inet_server_addr()::text"));
  assert.ok(sql.includes("'observed_server_port',pg_catalog.inet_server_port()"));
  assert.ok(sql.includes("'observed_ssl',(select ssl from pg_catalog.pg_stat_ssl"));
  assert.doesNotMatch(sql, /"(?:deployment_id|clinic_code|clinic_id|project_ref|database_origin)":/);
  assert.ok(sql.includes('"migration_count":45'));
  assert.ok(sql.includes(`"source_revision":"${revision}"`));
  assert.ok(sql.includes('"acl_phase":"strict-post-remediation"'));
  assert.ok(sql.includes('"acl_remediation_pending":false'));
  assert.ok(sql.includes('"browser_rpc_acl_remediation_pending":false'));
  assert.ok(sql.includes('"trigger_function_acl_remediation_pending":false'));
  assert.ok(sql.includes(
    `"repository_derived_treatment_session_acl_manifest_sha256":"${
      REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sha256
    }"`
  ));
  assert.ok(sql.includes(
    '"repository_derived_treatment_session_acl_provenance":' +
    '"repository-derived-not-live-observed"'
  ));
  assert.ok(sql.includes(
    '"repository_derived_treatment_session_public_execute_debt_pending":false'
  ));
  assert.ok(sql.includes('"authorization":false'));
  assert.doesNotMatch(sql, /"authorization":true/);
  assert.ok(sql.includes('"ledger_reconciliation_authorized":false'));
  assert.doesNotMatch(sql, /"ledger_reconciliation_authorized":true/);
  assert.ok(sql.includes('"live_callable_acl_inventory_required":true'));
  assert.ok(sql.includes('"live_callable_acl_inventory_complete":false'));
  assert.doesNotMatch(sql, /"live_callable_acl_inventory_complete":true/);
  assert.ok(sql.includes(
    '"ledger_reconciliation_blocked_pending_live_callable_acl_inventory":true'
  ));
  assert.ok(sql.includes('"ledger_reconciled":false'));
  assert.ok(sql.includes('"production_eligible":false'));
  assert.doesNotMatch(sql, /"production_eligible":true/);
  assert.ok(sql.includes('"rollback_required":true'));
  assert.doesNotMatch(
    sql,
    /Transitional observation manifest|transitional_|known_live_callable_acl_subset/
  );
  assert.match(
    sql,
    new RegExp(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.functionSemanticStrictSha256)
  );
  assert.doesNotMatch(
    sql,
    new RegExp(
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
        .functionSemanticPreReconciliationSha256
    )
  );
  assert.match(sql, new RegExp(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingSha256));
  assert.doesNotMatch(sql, new RegExp(preReconciliationVerificationStatus));
  assert.doesNotMatch(sql, /CNYOS_STAGING_SCHEMA_FINGERPRINT_VERIFIED/);
  assert.doesNotMatch(sql, /from public\.\w+_healthcheck\(\)/);
  assert.doesNotMatch(sql, /perform set_config\('request\.jwt/);
  assert.match(
    sql,
    /select system_identifier::text into v_observed_system_identifier\n  from pg_catalog\.pg_control_system\(\);/
  );
  if (configFile === 'config/tenant.cnyos-staging.json') {
    assert.match(sql, /v_observed_system_identifier is distinct from '7666007964130682852'/);
    assert.match(sql, /CNYOS_STAGING_VERIFICATION_WRONG_CLUSTER/);
    assert.ok(sql.includes("'expected_system_identifier','7666007964130682852'"));
    assert.ok(sql.includes('"target_identity_verified":true'));
    assert.ok(sql.includes('"target_identity_verification":"system-identifier-enforced"'));
    assert.doesNotMatch(sql, new RegExp(targetUnverifiedStrictVerificationStatus));
  } else {
    assert.doesNotMatch(sql, /7666007964130682852|CNYOS_STAGING_VERIFICATION_WRONG_CLUSTER/);
    assert.ok(sql.includes("'expected_system_identifier',null"));
    assert.ok(sql.includes('"target_identity_verified":false'));
    assert.ok(sql.includes(
      '"target_identity_verification":"target-unverified-system-identifier-unpinned"'
    ));
    assert.match(sql, new RegExp(targetUnverifiedStrictVerificationStatus));
    assert.doesNotMatch(sql, new RegExp(strictVerificationStatus));
  }

  assert.doesNotMatch(sql, /create schema if not exists supabase_migrations/i);
  assert.doesNotMatch(sql, /insert into supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(sql, /comment on table supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(sql, /\ncommit;\n/i);
  assert.match(
    sql,
    /\$ledger_guard\$;[\s\S]*\)::text as cnyos_verification_evidence\n\\gset\nrollback;\n\\unset cnyos_verification_lock_released\nselect pg_catalog\.pg_advisory_unlock\(202608302100::bigint\) as cnyos_verification_lock_released\n\\gset\n\\if :cnyos_verification_lock_released\n\\unset cnyos_verification_lock_fully_released\nselect not exists \([\s\S]*\) as cnyos_verification_lock_fully_released\n\\gset\n\\if :cnyos_verification_lock_fully_released\nselect \([\s\S]*'verification_transaction_rolled_back',true,[\s\S]*'advisory_lock_released',true[\s\S]*\) as migration_ledger_verification_evidence;\n\\else\n/
  );
  assert.match(sql, /CNYOS_STAGING_VERIFICATION_ADVISORY_UNLOCK_FAILED/);
  assert.match(
    sql,
    /\$cnyos_verification_unlock_abort\$;\n\\endif\n\\else\n[\s\S]*\$cnyos_verification_unlock_abort\$;\n\\endif\n[\s\S]*\\unset cnyos_verification_lock_fully_released\n\\unset cnyos_verification_evidence\n$/
  );
  assert.throws(() => buildMigrationLedgerVerificationSql({ config, entries }), /40-character/);
  assert.throws(() => buildMigrationLedgerVerificationSql({ config, entries, sourceRevision: 'abcdef0' }), /40-character/);

  const db = new PGlite();
  try {
    const pgliteIdentity = (await db.query(
      'select current_database() current_database, session_user::text session_user, ' +
      'current_user::text current_user'
    )).rows[0];
    const pgliteSystemIdentifier = (await db.query(
      'select system_identifier::text system_identifier from pg_catalog.pg_control_system()'
    )).rows[0].system_identifier;
    // PGlite does not parse psql metacommands. Exercise the exact generated SQL
    // body, while binding only the production database/role pins to this
    // in-memory server identity. The generated production source stays intact.
    const verificationGuardEndIndex = sql.indexOf(
      'end\n$ledger_guard$;\n',
      verificationBeginIndex
    ) + 'end\n$ledger_guard$;\n'.length;
    const executableProductionSql =
      sql.slice(verificationCommentIndex, verificationGuardEndIndex) + 'rollback;\n';
    assert.match(executableProductionSql, /^-- Generated read-only staging schema verification/);
    assert.doesNotMatch(executableProductionSql, /^\\/m);
    const bindPgliteIdentity = ({ current_database, session_user, current_user }) => {
      let boundSql = executableProductionSql;
      for (const [variable, productionValue, pgliteValue] of [
        ['v_observed_current_database', productionDatabaseName, current_database],
        ['v_observed_session_user', productionDatabaseRole, session_user],
        ['v_observed_current_user', productionDatabaseRole, current_user]
      ]) {
        const productionPin = `${variable} is distinct from ${quoteSqlLiteral(productionValue)}`;
        assert.ok(boundSql.includes(productionPin));
        boundSql = boundSql.replace(
          productionPin,
          `${variable} is distinct from ${quoteSqlLiteral(pgliteValue)}`
        );
      }
      return configFile === 'config/tenant.cnyos-staging.json'
        ? boundSql.replaceAll('7666007964130682852', pgliteSystemIdentifier)
        : boundSql;
    };
    const executableSql = bindPgliteIdentity(pgliteIdentity);
    // An explicitly ordered pg_catalog must outrank attacker-controlled temp
    // relations in a reused client session.
    await db.exec('create temp table pg_roles(blocker integer);');
    const notices = [];
    const options = { onNotice: notice => notices.push(notice.message) };
    // A blank database must fail without any success-shaped NOTICE.
    await assert.rejects(
      db.exec(executableSql, options),
      /STAGING_TRIGGER_FUNCTION_INVENTORY_OR_STATE_INVALID/
    );
    await db.exec('rollback;', options);
    assert.equal(notices.length, 0);

    const guardStart = executableSql.indexOf('do $ledger_guard$');
    const guardEnd = executableSql.indexOf('end\n$ledger_guard$;\n') +
      'end\n$ledger_guard$;\n'.length;
    const prefix = executableSql.slice(0, guardStart);
    const guard = executableSql.slice(guardStart, guardEnd);
    const suffix = executableSql.slice(guardEnd);
    assert.equal(suffix, 'rollback;\n');

    // Model a client that continues after an error, including one that uses
    // a savepoint to recover the failed statement (psql ON_ERROR_ROLLBACK).
    for (const useSavepoint of [false, true]) {
      notices.length = 0;
      await db.exec(prefix, options);
      if (useSavepoint) await db.exec('savepoint client_statement;', options);
      await assert.rejects(
        db.exec(guard, options),
        /STAGING_TRIGGER_FUNCTION_INVENTORY_OR_STATE_INVALID/
      );
      if (useSavepoint) await db.exec('rollback to savepoint client_statement;', options);
      await db.exec(suffix, options);
      assert.equal(notices.length, 0);
    }

    await db.exec('create table verifier_write_probe(id integer); create sequence verifier_sequence_probe;');
    for (const statement of [
      'insert into verifier_write_probe values (1)',
      "select nextval('verifier_sequence_probe')"
    ]) {
      await db.exec(prefix);
      await assert.rejects(db.exec(statement), /read-only transaction/i);
      await db.exec('rollback;');
    }
    assert.equal((await db.query('select count(*)::int count from verifier_write_probe')).rows[0].count, 0);
    assert.equal((await db.query('select is_called from verifier_sequence_probe')).rows[0].is_called, false);
    assert.equal((await db.query('show transaction_read_only')).rows[0].transaction_read_only, 'off');

    // A client can change transaction mode before the first query. The guard
    // must refuse execution if that client disables the read-only boundary.
    notices.length = 0;
    await db.exec(prefix);
    await db.exec('set transaction read write;');
    await assert.rejects(db.exec(guard, options), /STAGING_VERIFICATION_READ_ONLY_REQUIRED/);
    await db.exec('rollback;');
    assert.equal(notices.length, 0);

    // Refuse a client that weakens isolation before the guard establishes its
    // first snapshot, even though the transaction remains read-only.
    notices.length = 0;
    await db.exec(prefix);
    await db.exec('set transaction isolation level read committed;');
    await assert.rejects(db.exec(guard, options), /STAGING_VERIFICATION_REPEATABLE_READ_REQUIRED/);
    await db.exec('rollback;');
    assert.equal(notices.length, 0);

    // Catalog verification must not evaluate drifted RLS policies as its reader.
    await db.exec('create role unprivileged_verifier; set role unprivileged_verifier;');
    const unprivilegedExecutableSql = bindPgliteIdentity({
      ...pgliteIdentity,
      current_user: 'unprivileged_verifier'
    });
    await assert.rejects(
      db.exec(unprivilegedExecutableSql, options),
      /STAGING_VERIFICATION_CATALOG_READER_REQUIRED/
    );
    await db.exec('rollback; reset role;');
    assert.equal(notices.length, 0);
  } finally {
    await db.close();
  }
}

const unreviewedChananyaProjectConfig = structuredClone(JSON.parse(fs.readFileSync(
  path.join(root, 'config/tenant.cnyos-staging.json'),
  'utf8'
)));
unreviewedChananyaProjectConfig.deploymentId = 'chananya-clinical-staging-unreviewed';
const unreviewedChananyaProjectVerificationSql = buildMigrationLedgerVerificationSql({
  config: unreviewedChananyaProjectConfig,
  entries,
  sourceRevision: revision
});
assert.doesNotMatch(
  unreviewedChananyaProjectVerificationSql,
  /7666007964130682852|CNYOS_STAGING_VERIFICATION_WRONG_CLUSTER/,
  'the reviewed cluster identity must require the exact reviewed target metadata, not project ref alone'
);
assert.ok(unreviewedChananyaProjectVerificationSql.includes(
  "'expected_system_identifier',null"
));
assert.match(
  unreviewedChananyaProjectVerificationSql,
  new RegExp(targetUnverifiedStrictVerificationStatus)
);
assert.doesNotMatch(unreviewedChananyaProjectVerificationSql, new RegExp(strictVerificationStatus));
assert.match(unreviewedChananyaProjectVerificationSql, /"target_identity_verified":false/);
assert.match(unreviewedChananyaProjectVerificationSql, /"authorization":false/);
assert.match(unreviewedChananyaProjectVerificationSql, /"ledger_reconciliation_authorized":false/);
assert.match(unreviewedChananyaProjectVerificationSql, /"live_callable_acl_inventory_required":true/);
assert.match(unreviewedChananyaProjectVerificationSql, /"live_callable_acl_inventory_complete":false/);
assert.match(unreviewedChananyaProjectVerificationSql, /"production_eligible":false/);

const cnyosConfig = JSON.parse(fs.readFileSync(
  path.join(root, 'config/tenant.cnyos-staging.json'),
  'utf8'
));
const jitarsaConfig = JSON.parse(fs.readFileSync(
  path.join(root, 'config/tenant.jitarsa-staging.json'),
  'utf8'
));
const transitionManifest = CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST;
const independentlyReviewedTransitionTuples = [
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
assert.equal(transitionManifest.projectRef, 'hsmnjwxurlmsizndjlun');
assert.equal(transitionManifest.databaseOrigin, 'https://hsmnjwxurlmsizndjlun.supabase.co');
assert.equal(transitionManifest.observedAt, '2026-09-06T15:42:14.891459Z');
assert.equal(transitionManifest.observationSourceRevision, '79750ef1f5bb3baa82f57687276b6efb1a2d345c');
assert.equal(transitionManifest.tupleSha256, '3d6fe1f67c0c2bc418c412b30b0c439f9f5c3c6ba2757bc212cb5f5f9c029695');
assert.equal(transitionManifest.browserRpcAclTuples.length, 22);
assert.equal(transitionManifest.browserRpcAclTuples.filter(([grantee]) => grantee === 'anon').length, 17);
assert.equal(transitionManifest.browserRpcAclTuples.filter(([grantee]) => grantee === 'service_role').length, 5);
assert.equal(new Set(transitionManifest.browserRpcAclTuples.map(tuple => tuple.join('\t'))).size, 22);
assert.deepEqual(transitionManifest.browserRpcAclTuples, independentlyReviewedTransitionTuples);
assert.equal(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.triggerInventory.length, 23);
assert.equal(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.aclTuples.length, 62);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.inventorySha256,
  '4ff91cbb4fca03b8f7f2d0eaa6dc47b198ea7ce592a1d624d5b72bc273558a0d'
);
assert.equal(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.functionSemanticCount, 23);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
    .functionSemanticPreReconciliationPayloadBytes,
  21183
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.functionSemanticPreReconciliationSha256,
  '4c92389f247e80c27c63721eff19f321ed538c8e70d616df5aa36e193cb2eb0b'
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.functionSemanticStrictPayloadBytes,
  21213
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.functionSemanticStrictSha256,
  '07535c64e7607d8cc9bc34b197a40e3923f4f56df84262d041d56541b1890737'
);
assert.equal(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingCount, 168);
assert.equal(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingPayloadBytes, 46998);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingSha256,
  '9430970d3b25cbe3d5d4ab704740e62ce5a6864d9a804a732ed6f8919523fe54'
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.aclTupleSha256,
  'bd0391e6a7f6a06797fde1d9f9e90e2a475cf2679b298f86b7b8492980a39b11'
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.sha256,
  '2f4ec29006a5a2b3a0e3b2d7aa9018861bee5153b60887c625d6a46d2516a733'
);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.evidenceScope,
  'known-live-callable-acl-subset-not-complete-inventory'
);
assert.equal(CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.liveCallableAclInventoryComplete, false);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.evidenceScope,
  'reviewed-evidence-bundle-not-complete-live-callable-acl-inventory'
);
assert.equal(CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.authorization, false);
assert.equal(
  CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.liveCallableAclInventoryComplete,
  false
);
assert.equal(
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.sha256,
  'e63988b0af540d23a336194dc14e5b90b9dbf4d26ff349d60a100dedf3469013'
);
assert.equal(
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.provenance,
  'repository-derived-not-live-observed'
);
assert.equal(
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.procedureSignature,
  'public.create_clinical_treatment_session(uuid,text[],text,boolean,text,text,smallint,smallint,text,text)'
);
assert.equal(
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST
    .semanticContract.normalizedBodySha256,
  'cb43d26f1df8eb76c1bf7451eccbbb007538928c8de73bbcbe00321d252182fc'
);
assert.deepEqual(
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST
    .preReconciliationAcl.directOwnerGrantedNonGrantableExecuteGrantees,
  ['PUBLIC', 'authenticated']
);
assert.deepEqual(
  REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST
    .strictPostRemediationAcl.directOwnerGrantedNonGrantableExecuteGrantees,
  ['authenticated']
);
assert.equal(
  transitionManifest.browserRpcAclTuples.some(([, procedureSignature]) =>
    procedureSignature ===
      REPOSITORY_DERIVED_CLINICAL_TREATMENT_SESSION_ACL_MANIFEST.procedureSignature
  ),
  false,
  'the repository-derived debt must not be relabeled as one of the 22 live-observed tuples'
);

assert.equal(
  buildMigrationLedgerVerificationSql({
    config: cnyosConfig,
    entries,
    sourceRevision: revision
  }),
  buildMigrationLedgerVerificationSql({
    config: cnyosConfig,
    entries,
    sourceRevision: revision,
    aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
  }),
  'omitting aclPhase must be byte-for-byte strict post-remediation output'
);
assert.equal(
  buildMigrationLedgerRepairSql({
    config: cnyosConfig,
    entries,
    sourceRevision: revision
  }),
  buildMigrationLedgerRepairSql({
    config: cnyosConfig,
    entries,
    sourceRevision: revision,
    aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
  }),
  'omitting aclPhase must be byte-for-byte strict repair output'
);
for (const sourceRevision of ['', '79750ef']) {
  assert.throws(
    () => buildMigrationLedgerRepairSql({
      config: cnyosConfig,
      entries,
      sourceRevision
    }),
    /full 40-character artifact source revision/
  );
}

const preReconciliationVerificationSql = buildMigrationLedgerVerificationSql({
  config: cnyosConfig,
  entries,
  sourceRevision: revision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
});
assertVerifierHasNoWriteOrApplicationCallSurface(
  preReconciliationVerificationSql,
  'Chananya pre-reconciliation verifier'
);
assertVerifierPinsCanonicalCatalogOutputGucs(
  preReconciliationVerificationSql,
  'Chananya pre-reconciliation verifier'
);
const preReconciliationRepairSql = buildMigrationLedgerRepairSql({
  config: cnyosConfig,
  entries,
  sourceRevision: revision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
});
const strictRepairSql = buildMigrationLedgerRepairSql({
  config: cnyosConfig,
  entries,
  sourceRevision: revision,
  aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
});
assert.match(
  preReconciliationVerificationSql,
  /-- Generated read-only staging schema verification \(chananya-pre-reconciliation\)\./
);
assert.ok(preReconciliationVerificationSql.startsWith(verificationPsqlPreflight));
assert.match(
  preReconciliationVerificationSql,
  new RegExp(`"status":"${preReconciliationVerificationStatus}"`)
);
assert.match(preReconciliationVerificationSql, /"acl_remediation_pending":true/);
assert.match(preReconciliationVerificationSql, /"browser_rpc_acl_remediation_pending":true/);
assert.match(preReconciliationVerificationSql, /"trigger_function_acl_remediation_pending":true/);
assert.match(
  preReconciliationVerificationSql,
  /"repository_derived_treatment_session_public_execute_debt_pending":true/
);
assert.match(preReconciliationVerificationSql, /"live_callable_acl_inventory_required":true/);
assert.match(preReconciliationVerificationSql, /"live_callable_acl_inventory_complete":false/);
assert.doesNotMatch(preReconciliationVerificationSql, /"live_callable_acl_inventory_complete":true/);
assert.match(preReconciliationVerificationSql, /"authorization":false/);
assert.doesNotMatch(preReconciliationVerificationSql, /"authorization":true/);
assert.match(preReconciliationVerificationSql, /"ledger_reconciliation_authorized":false/);
assert.doesNotMatch(preReconciliationVerificationSql, /"ledger_reconciliation_authorized":true/);
assert.match(preReconciliationVerificationSql, /"target_identity_verified":true/);
assert.match(
  preReconciliationVerificationSql,
  /"target_identity_verification":"system-identifier-enforced"/
);
assert.match(preReconciliationVerificationSql, /"live_callable_acl_known_subset_only":true/);
assert.match(
  preReconciliationVerificationSql,
  /"ledger_reconciliation_blocked_pending_live_callable_acl_inventory":true/
);
assert.match(preReconciliationVerificationSql, /"ledger_reconciled":false/);
assert.match(preReconciliationVerificationSql, /"production_eligible":false/);
assert.doesNotMatch(preReconciliationVerificationSql, /"production_eligible":true/);
assert.ok(preReconciliationVerificationSql.includes(
  "from (values ('PUBLIC'),('authenticated')) expected(expected_grantee)"
));
assert.ok(preReconciliationVerificationSql.includes(
  "from (values ('anon','true'),('authenticated','true'),('service_role','true')) expected("
));
assert.match(preReconciliationVerificationSql, new RegExp(transitionManifest.tupleSha256));
assert.match(
  preReconciliationVerificationSql,
  new RegExp(CHANANYA_PRE_RECONCILIATION_KNOWN_EVIDENCE_BUNDLE.sha256)
);
assert.match(
  preReconciliationVerificationSql,
  new RegExp(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingSha256)
);
assert.match(
  preReconciliationVerificationSql,
  new RegExp(
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
      .functionSemanticPreReconciliationSha256
  )
);
assert.doesNotMatch(
  preReconciliationVerificationSql,
  new RegExp(CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.functionSemanticStrictSha256)
);
assert.ok(preReconciliationVerificationSql.includes(
  `"reviewed_trigger_binding_sha256":"${
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingSha256
  }"`
));
assert.ok(preReconciliationVerificationSql.includes(
  `"reviewed_trigger_binding_count":${
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingCount
  }`
));
assert.ok(preReconciliationVerificationSql.includes(
  `"reviewed_trigger_binding_payload_bytes":${
    CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingPayloadBytes
  }`
));
assert.ok(preReconciliationVerificationSql.includes(
  `"known_live_callable_acl_subset_count":${
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.browserRpcAclTuples.length
  }`
));
assert.ok(preReconciliationVerificationSql.includes(
  `"known_live_callable_acl_subset_sha256":"${
    CHANANYA_PRE_RECONCILIATION_ACL_MANIFEST.tupleSha256
  }"`
));
assert.doesNotMatch(preReconciliationVerificationSql, /transitional_observation_manifest_sha256/);
assert.match(preReconciliationVerificationSql, /STAGING_TRIGGER_BINDING_SNAPSHOT_INVALID/);
assert.match(preReconciliationVerificationSql, /encode\(sha256\(convert_to/);
assert.doesNotMatch(preReconciliationVerificationSql, new RegExp(strictVerificationStatus));
assert.doesNotMatch(preReconciliationVerificationSql, /\bREADY\b/);
assert.match(
  preReconciliationVerificationSql,
  /rollback;\n\\unset cnyos_verification_lock_released\nselect pg_catalog\.pg_advisory_unlock\(202608302100::bigint\) as cnyos_verification_lock_released/
);
assert.match(
  preReconciliationVerificationSql,
  /\\if :cnyos_verification_lock_released\n\\unset cnyos_verification_lock_fully_released\nselect not exists \([\s\S]*\) as cnyos_verification_lock_fully_released\n\\gset\n\\if :cnyos_verification_lock_fully_released\nselect \([\s\S]*'verification_transaction_rolled_back',true,[\s\S]*'advisory_lock_released',true[\s\S]*\) as migration_ledger_verification_evidence;\n\\else\n[\s\S]*CNYOS_STAGING_VERIFICATION_ADVISORY_UNLOCK_FAILED[\s\S]*\\endif\n\\else\n[\s\S]*CNYOS_STAGING_VERIFICATION_ADVISORY_UNLOCK_FAILED[\s\S]*\\endif\n[\s\S]*\\unset cnyos_verification_evidence\n$/
);

assert.match(
  preReconciliationRepairSql,
  /\n-- Generated one-time staging migration ledger recovery \(chananya-pre-reconciliation\)\./
);
const repairPsqlPreflight = [
  '\\set ON_ERROR_STOP 1',
  '\\set ON_ERROR_ROLLBACK off',
  '\\unset cnyos_repair_probe_xid',
  '\\unset cnyos_repair_existing_transaction',
  '\\unset cnyos_repair_session_nonce',
  '\\unset cnyos_repair_committed_nonce',
  '\\unset cnyos_repair_committed_xid',
  '\\unset cnyos_repair_connection_ok',
  '\\unset cnyos_repair_server_identity_ok',
  '\\unset cnyos_repair_lock_unheld',
  '\\unset cnyos_repair_lock_acquired',
  '\\unset cnyos_repair_evidence',
  '\\unset cnyos_repair_lock_released',
  '\\unset cnyos_repair_lock_fully_released',
  '\\unset cnyos_repair_run_nonce',
  '\\if :AUTOCOMMIT',
  '\\else',
  "\\warn 'CNYOS ledger repair requires psql AUTOCOMMIT=on; rolling back and refusing execution'",
  'rollback;',
  'do $cnyos_psql_preflight_abort$',
  'begin',
  "  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED';",
  'end',
  '$cnyos_psql_preflight_abort$;',
  '\\endif',
  'set search_path = pg_catalog, pg_temp, public;',
  'select (',
  "  :'HOST' = 'db.hsmnjwxurlmsizndjlun.supabase.co'",
  "  and :'PORT' = '5432'",
  "  and :'USER' = 'postgres'",
  "  and :'DBNAME' = 'postgres'",
  ') as cnyos_repair_connection_ok',
  '\\gset',
  '\\if :cnyos_repair_connection_ok',
  '\\else',
  "\\warn 'CNYOS ledger repair requires the exact direct Chananya PostgreSQL endpoint db.hsmnjwxurlmsizndjlun.supabase.co:5432, database postgres, user postgres'",
  'do $cnyos_psql_connection_abort$',
  'begin',
  "  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_CONNECTION_IDENTITY_REFUSED';",
  'end',
  '$cnyos_psql_connection_abort$;',
  '\\endif',
  'select (',
  "  pg_catalog.current_database() = 'postgres'",
  "  and session_user = 'postgres'",
  "  and current_user = 'postgres'",
  ') as cnyos_repair_server_identity_ok',
  '\\gset',
  '\\if :cnyos_repair_server_identity_ok',
  '\\else',
  "\\warn 'CNYOS ledger repair requires server database/session_user/current_user postgres'",
  'do $cnyos_psql_server_identity_abort$',
  'begin',
  "  raise exception 'CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED';",
  'end',
  '$cnyos_psql_server_identity_abort$;',
  '\\endif',
  'select pg_catalog.pg_current_xact_id()::text as cnyos_repair_probe_xid',
  '\\gset',
  '\\unset cnyos_repair_existing_transaction',
  "select (\n  pg_catalog.pg_current_xact_id()::text = :'cnyos_repair_probe_xid'\n) as cnyos_repair_existing_transaction",
  '\\gset',
  '\\if :cnyos_repair_existing_transaction',
  "\\warn 'CNYOS ledger repair detected and rolled back an existing transaction; refusing execution'",
  'rollback;',
  'do $cnyos_psql_preflight_abort$',
  'begin',
  "  raise exception 'CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED';",
  'end',
  '$cnyos_psql_preflight_abort$;',
  '\\endif',
  'select pg_catalog.gen_random_uuid()::text as cnyos_repair_run_nonce',
  '\\gset',
  'select pg_catalog.set_config(',
  "  'cnyos.migration_ledger_repair_run_nonce',",
  "  :'cnyos_repair_run_nonce',",
  '  false',
  ') as cnyos_repair_session_nonce',
  '\\gset',
  'select pg_catalog.set_config(',
  "  'cnyos.migration_ledger_repair_committed_nonce',",
  "  '',",
  '  false',
  ') as cnyos_repair_committed_nonce',
  '\\gset',
  'select pg_catalog.set_config(',
  "  'cnyos.migration_ledger_repair_committed_xid',",
  "  '',",
  '  false',
  ') as cnyos_repair_committed_xid',
  '\\gset',
  "select pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_host',:'HOST',false),",
  "  pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_port',:'PORT',false),",
  "  pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_user',:'USER',false),",
  "  pg_catalog.set_config('cnyos.migration_ledger_repair_observed_psql_database',:'DBNAME',false);",
  'select not exists (',
  '  select 1',
  '  from pg_catalog.pg_locks',
  "  where locktype='advisory' and pid=pg_catalog.pg_backend_pid() and granted",
  '    and classid::bigint=(202608302100::bigint >> 32)',
  '    and objid::bigint=(202608302100::bigint & 4294967295::bigint)',
  '    and objsubid=1',
  ') as cnyos_repair_lock_unheld',
  '\\gset',
  '\\if :cnyos_repair_lock_unheld',
  '\\else',
  "\\warn 'CNYOS ledger repair requires the advisory key to be unheld by this session'",
  'do $cnyos_psql_lock_state_abort$',
  'begin',
  "  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_ALREADY_HELD';",
  'end',
  '$cnyos_psql_lock_state_abort$;',
  '\\endif',
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) as cnyos_repair_lock_acquired',
  '\\gset',
  '\\if :cnyos_repair_lock_acquired',
  '\\else',
  "\\warn 'CNYOS ledger repair advisory key is busy; refusing rather than waiting'",
  'do $cnyos_psql_lock_busy_abort$',
  'begin',
  "  raise exception 'CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_BUSY';",
  'end',
  '$cnyos_psql_lock_busy_abort$;',
  '\\endif'
].join('\n') + '\n';
assert.ok(
  preReconciliationRepairSql.startsWith(repairPsqlPreflight),
  'repair must clear stale client state and hard-fail unsafe psql transaction modes'
);
assert.doesNotMatch(preReconciliationRepairSql, /^\\q(?:uit)?(?:\s|$)/m);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_PSQL_AUTOCOMMIT_REQUIRED/);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_PSQL_CONNECTION_IDENTITY_REFUSED/);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_SERVER_IDENTITY_REFUSED/);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_PSQL_EXISTING_TRANSACTION_REFUSED/);
assert.equal(
  (preReconciliationRepairSql.match(
    /v_observed_current_database is distinct from 'postgres'/g
  ) ?? []).length,
  2,
  'both the schema guard and the repair block must pin current_database server-side'
);
assert.equal(
  (preReconciliationRepairSql.match(
    /v_observed_session_user is distinct from 'postgres'/g
  ) ?? []).length,
  2,
  'both the schema guard and the repair block must pin session_user server-side'
);
assert.equal(
  (preReconciliationRepairSql.match(
    /v_observed_current_user is distinct from 'postgres'/g
  ) ?? []).length,
  2,
  'both the schema guard and the repair block must pin current_user server-side'
);
const repairSessionLockIndex = preReconciliationRepairSql.indexOf(
  'select pg_catalog.pg_try_advisory_lock(202608302100::bigint) ' +
    'as cnyos_repair_lock_acquired'
);
const repairGeneratedCommentIndex = preReconciliationRepairSql.indexOf(
  '-- Generated one-time staging migration ledger recovery'
);
assert.ok(
  repairSessionLockIndex !== -1 &&
  repairSessionLockIndex < repairGeneratedCommentIndex,
  'repair must take its session advisory lock before entering generated transactional SQL'
);
assert.doesNotMatch(
  preReconciliationRepairSql,
  /select pg_catalog\.pg_advisory_lock\(202608302100::bigint\);/,
  'repair must never wait indefinitely for the advisory key'
);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_ALREADY_HELD/);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_ADVISORY_LOCK_BUSY/);
assert.match(
  preReconciliationRepairSql,
  /select pg_catalog\.set_config\(\n  'cnyos\.migration_ledger_repair_run_nonce',\n  :'cnyos_repair_run_nonce',\n  false\n\) as cnyos_repair_session_nonce\n\\gset\nselect pg_catalog\.set_config\(\n  'cnyos\.migration_ledger_repair_committed_nonce',\n  '',\n  false\n\) as cnyos_repair_committed_nonce\n\\gset\n/
);
assert.match(
  preReconciliationRepairSql,
  /CNYOS_CHANANYA_STAGING_LEDGER_RECONCILED_BROWSER_RPC_AND_TRIGGER_REMEDIATIONS_PENDING/
);
assert.match(
  preReconciliationRepairSql,
  /CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED/
);
assert.equal(
  (preReconciliationRepairSql.match(
    /CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED/g
  ) ?? []).length,
  2,
  'pre-reconciliation guard and repair blocks must each refuse writes'
);
const preReconciliationRepairWriteBlock = preReconciliationRepairSql.slice(
  preReconciliationRepairSql.indexOf('do $ledger_repair$'),
  preReconciliationRepairSql.indexOf('end\n$ledger_repair$;')
);
assert.match(
  preReconciliationRepairWriteBlock,
  /^do \$ledger_repair\$\ndeclare\n(?:  v_[^\n]+;\n)+begin\n  raise exception 'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED:/
);
assert.doesNotMatch(
  preReconciliationRepairWriteBlock.slice(
    0,
    preReconciliationRepairWriteBlock.indexOf(
      'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED'
    )
  ),
  /:=|\b(?:select|perform|execute|insert|update|delete|create|alter|drop)\b/i
);
assert.match(preReconciliationRepairSql, /'acl_remediation_pending',true/);
assert.match(preReconciliationRepairSql, /'expected_project_ref','hsmnjwxurlmsizndjlun'/);
assert.match(
  preReconciliationRepairSql,
  /'expected_database_origin','https:\/\/hsmnjwxurlmsizndjlun\.supabase\.co'/
);
assert.match(preReconciliationRepairSql, /'expected_database_host','db\.hsmnjwxurlmsizndjlun\.supabase\.co'/);
assert.match(preReconciliationRepairSql, /'expected_current_database','postgres'/);
assert.match(preReconciliationRepairSql, /'expected_session_user','postgres'/);
assert.match(preReconciliationRepairSql, /'expected_current_user','postgres'/);
assert.match(preReconciliationRepairSql, /'expected_system_identifier','7666007964130682852'/);
assert.match(preReconciliationRepairSql, /'observed_system_identifier',v_observed_system_identifier/);
assert.match(
  preReconciliationRepairSql,
  /'observed_psql_host',current_setting\('cnyos\.migration_ledger_repair_observed_psql_host'\)/
);
assert.match(
  preReconciliationRepairSql,
  /'observed_psql_port',current_setting\('cnyos\.migration_ledger_repair_observed_psql_port'\)/
);
assert.match(
  preReconciliationRepairSql,
  /'observed_psql_user',current_setting\('cnyos\.migration_ledger_repair_observed_psql_user'\)/
);
assert.match(
  preReconciliationRepairSql,
  /'observed_psql_database',current_setting\('cnyos\.migration_ledger_repair_observed_psql_database'\)/
);
assert.match(preReconciliationRepairSql, /'observed_current_database',v_observed_current_database/);
assert.match(preReconciliationRepairSql, /'observed_session_user',v_observed_session_user/);
assert.match(preReconciliationRepairSql, /'observed_current_user',v_observed_current_user/);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_WRONG_CLUSTER/);
assert.doesNotMatch(preReconciliationRepairSql, /'project_ref','hsmnjwxurlmsizndjlun'/);
assert.doesNotMatch(
  preReconciliationRepairSql,
  /'database_origin','https:\/\/hsmnjwxurlmsizndjlun\.supabase\.co'/
);
assert.match(preReconciliationRepairSql, /'ledger_reconciled',true/);
assert.match(preReconciliationRepairSql, /'production_eligible',false/);
assert.match(preReconciliationRepairSql, new RegExp(transitionManifest.tupleSha256));
assert.match(
  preReconciliationRepairSql,
  new RegExp(
    `'trigger_function_semantic_sha256','${
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST
        .functionSemanticPreReconciliationSha256
    }'`
  )
);
assert.match(
  preReconciliationRepairSql,
  new RegExp(
    `'trigger_binding_sha256','${
      CHANANYA_PRE_RECONCILIATION_TRIGGER_MANIFEST.bindingSha256
    }'`
  )
);
assert.equal(
  (preReconciliationRepairSql.match(
    /current_setting\('cnyos\.migration_ledger_repair_run_nonce'\)::uuid/g
  ) ?? []).length,
  2,
  'the guarded marker and mutation blocks must each retain one nonce binding'
);
const firstRepairAuthorizationBlockerIndex = preReconciliationRepairSql.indexOf(
  'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED'
);
const guardNonceUseIndex = preReconciliationRepairSql.indexOf(
  "current_setting('cnyos.migration_ledger_repair_run_nonce')::uuid",
  firstRepairAuthorizationBlockerIndex
);
const secondRepairAuthorizationBlockerIndex = preReconciliationRepairSql.indexOf(
  'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED',
  firstRepairAuthorizationBlockerIndex + 1
);
const mutationNonceAssignmentIndex = preReconciliationRepairSql.indexOf(
  "v_run_nonce := current_setting('cnyos.migration_ledger_repair_run_nonce')::uuid",
  secondRepairAuthorizationBlockerIndex
);
assert.ok(
  firstRepairAuthorizationBlockerIndex !== -1 &&
  firstRepairAuthorizationBlockerIndex < guardNonceUseIndex &&
  guardNonceUseIndex < secondRepairAuthorizationBlockerIndex &&
  secondRepairAuthorizationBlockerIndex < mutationNonceAssignmentIndex,
  'both pre-reconciliation blockers must abort before their guarded nonce use'
);
assert.equal(
  (strictRepairSql.match(
    /current_setting\('cnyos\.migration_ledger_repair_run_nonce'\)::uuid/g
  ) ?? []).length,
  2,
  'the strict repair path must preserve its nonce-bound declaration and marker checks'
);
assert.match(preReconciliationRepairSql, /'repair_run_nonce',v_run_nonce/);
assert.match(
  preReconciliationRepairSql,
  /create table if not exists supabase_migrations\.cnyos_migration_ledger_repair_receipts/
);
assert.match(preReconciliationRepairSql, /constraint cnyos_repair_receipt_gate_token_check check/);
assert.match(preReconciliationRepairSql, /constraint cnyos_repair_receipt_xid_check check/);
assert.ok(preReconciliationRepairSql.includes(
  "constraint cnyos_repair_receipt_evidence_check check (" +
  "(pg_catalog.jsonb_typeof(evidence)=''object'' and " +
  "evidence->>''repair_gate_token''=gate_token and " +
  "evidence->>''repair_run_nonce''=run_nonce::text and " +
  "evidence->>''repair_transaction_xid''=repair_xid) is true)"
));
assert.ok(preReconciliationRepairSql.includes(
  "('cnyos_repair_receipt_evidence_check','CHECK (" +
  "(jsonb_typeof(evidence) = ''object''::text AND " +
  "(evidence ->> ''repair_gate_token''::text) = gate_token AND " +
  "(evidence ->> ''repair_run_nonce''::text) = run_nonce::text AND " +
  "(evidence ->> ''repair_transaction_xid''::text) = repair_xid) IS TRUE)')"
));
assert.equal(
  (preReconciliationRepairSql.match(/cnyos_repair_receipt_evidence_check/g) ?? []).length,
  2,
  'the receipt DDL and exact catalog guard must both require a total evidence CHECK'
);
const repairCatalogGuardStart = preReconciliationRepairSql.indexOf(
  '  if not exists (\n    select 1 from pg_catalog.pg_namespace namespace'
);
const repairCatalogGuardEnd = preReconciliationRepairSql.indexOf(
  '  if exists (\n    select 1 from supabase_migrations.cnyos_migration_ledger_repair_receipts',
  repairCatalogGuardStart
);
assert.notEqual(repairCatalogGuardStart, -1);
assert.notEqual(repairCatalogGuardEnd, -1);
const repairCatalogGuards = preReconciliationRepairSql.slice(
  repairCatalogGuardStart,
  repairCatalogGuardEnd
);
for (const exactCatalogFailure of [
  'CNYOS_LEDGER_REPAIR_SCHEMA_SECURITY_INVALID',
  'CNYOS_LEDGER_REPAIR_LEDGER_SECURITY_INVALID',
  'CNYOS_LEDGER_REPAIR_LEDGER_SHAPE_INVALID',
  'CNYOS_LEDGER_REPAIR_LEDGER_CONSTRAINT_INVALID',
  'CNYOS_LEDGER_REPAIR_RECEIPT_SECURITY_INVALID',
  'CNYOS_LEDGER_REPAIR_RECEIPT_SHAPE_INVALID',
  'CNYOS_LEDGER_REPAIR_RELATION_HOOK_INVALID',
  'CNYOS_LEDGER_REPAIR_RECEIPT_CONSTRAINT_INVALID'
]) {
  assert.equal(
    preReconciliationRepairSql.split(exactCatalogFailure).length - 1,
    1,
    `${exactCatalogFailure} must remain an exact fail-closed catalog guard`
  );
}
assert.match(
  repairCatalogGuards,
  /namespace\.nspname='supabase_migrations'[\s\S]*owner_role\.rolname='postgres'[\s\S]*pg_catalog\.aclexplode\(coalesce\([\s\S]*namespace\.nspacl,pg_catalog\.acldefault\('n',namespace\.nspowner\)/
);
for (const relationName of [
  'schema_migrations',
  'cnyos_migration_ledger_repair_receipts'
]) {
  const relationGuardStart = repairCatalogGuards.indexOf(
    `relation.oid='supabase_migrations.${relationName}'::regclass`
  );
  assert.notEqual(relationGuardStart, -1);
  const relationGuard = repairCatalogGuards.slice(relationGuardStart);
  assert.match(
    relationGuard,
    /relation\.relkind='r' and relation\.relpersistence='p'[\s\S]*not relation\.relispartition and not relation\.relrowsecurity[\s\S]*not relation\.relforcerowsecurity and relation\.relreplident='d'[\s\S]*owner_role\.rolname='postgres'[\s\S]*pg_catalog\.aclexplode\(coalesce\([\s\S]*relation\.relacl,pg_catalog\.acldefault\('r',relation\.relowner\)[\s\S]*pg_catalog\.pg_inherits[\s\S]*pg_catalog\.pg_policy/
  );
}
assert.match(
  repairCatalogGuards,
  /where relation\.oid in \(\n      'supabase_migrations\.schema_migrations'::regclass,\n      'supabase_migrations\.cnyos_migration_ledger_repair_receipts'::regclass\n    \) and \(relation\.relhastriggers or relation\.relhasrules\n      or exists \(select 1 from pg_catalog\.pg_trigger where tgrelid=relation\.oid\)\n      or exists \(select 1 from pg_catalog\.pg_rewrite where ev_class=relation\.oid\)\)/
);
assert.match(
  repairCatalogGuards,
  /pg_catalog\.pg_get_constraintdef\(constraint_definition\.oid,true\)='PRIMARY KEY \(version\)'[\s\S]*where conrelid='supabase_migrations\.schema_migrations'::regclass\) <> 1[\s\S]*where indrelid='supabase_migrations\.schema_migrations'::regclass\) <> 1/
);
assert.match(
  repairCatalogGuards,
  /pg_catalog\.pg_get_constraintdef\(constraint_definition\.oid,true\)='PRIMARY KEY \(run_nonce\)'[\s\S]*pg_catalog\.pg_get_constraintdef\(constraint_definition\.oid,true\)='UNIQUE \(gate_token, repair_xid\)'[\s\S]*constraint_definition\.contype='c'[\s\S]*\) <> 3 or \([\s\S]*\) <> 5 or \([\s\S]*\) <> 2 then/
);
assert.equal(
  (preReconciliationRepairSql.match(/set constraints all immediate;/g) ?? []).length,
  2,
  'repair must force constraints after the ledger write and again after the receipt insert'
);
assert.match(preReconciliationRepairSql, /CNYOS_LEDGER_REPAIR_NONCE_REPLAY/);
assert.match(preReconciliationRepairSql, /on commit drop/);
assert.doesNotMatch(preReconciliationRepairSql, /on commit preserve rows/);
assert.doesNotMatch(preReconciliationRepairSql, /\bREADY\b/);
assert.match(preReconciliationRepairSql, /\ncommit;\n/);
const repairMarkerDropIndex = preReconciliationRepairSql.indexOf(
  'drop table if exists pg_temp.cnyos_migration_ledger_repair_evidence;'
);
const repairBeginIndex = preReconciliationRepairSql.indexOf(
  '\nbegin isolation level repeatable read read write;\n'
);
const repairWriteSearchPathIndex = preReconciliationRepairSql.indexOf(
  'set local search_path = pg_catalog, pg_temp, public;',
  repairBeginIndex
);
const repairGuardIndex = preReconciliationRepairSql.indexOf('do $ledger_guard$');
const repairLiveAclInventoryBlockerIndex = preReconciliationRepairSql.indexOf(
  'CNYOS_LEDGER_REPAIR_LIVE_CALLABLE_ACL_INVENTORY_REQUIRED'
);
const repairTransactionModeCheckIndex = preReconciliationRepairSql.indexOf(
  "current_setting('transaction_isolation') <> 'repeatable read'",
  repairGuardIndex
);
const repairSystemIdentityCheckIndex = preReconciliationRepairSql.indexOf(
  'if v_observed_system_identifier is distinct from',
  repairGuardIndex
);
const repairNonceCheckIndex = preReconciliationRepairSql.indexOf(
  'STAGING_LEDGER_REPAIR_RUN_NONCE_REQUIRED',
  repairGuardIndex
);
const repairXidAllocationIndex = preReconciliationRepairSql.indexOf(
  'v_repair_xid := pg_catalog.pg_current_xact_id()'
);
const repairFirstCatalogCheckIndex = preReconciliationRepairSql.indexOf(
  'select string_agg(procedure_signature',
  repairGuardIndex
);
const repairFirstHealthcheckIndex = preReconciliationRepairSql.indexOf(
  'from public.hybrid_patient_identity_healthcheck()'
);
const repairMarkerCreateIndex = preReconciliationRepairSql.indexOf(
  'create temporary table cnyos_migration_ledger_repair_evidence'
);
const repairWriteIndex = preReconciliationRepairSql.indexOf('do $ledger_repair$');
const repairFirstInsertIndex = preReconciliationRepairSql.indexOf(
  'insert into supabase_migrations.schema_migrations',
  repairWriteIndex
);
const repairCommittedNonceSetIndex = preReconciliationRepairSql.indexOf(
  "perform set_config('cnyos.migration_ledger_repair_committed_nonce'," +
    'v_run_nonce::text,false);'
);
const repairCommitIndex = preReconciliationRepairSql.lastIndexOf('\ncommit;\n');
const repairEvidenceIndex = preReconciliationRepairSql.lastIndexOf(
  'select case when count(*)=1 then min(receipt.evidence::text) end as cnyos_repair_evidence'
);
const repairFirstSetConstraintsIndex = preReconciliationRepairSql.indexOf(
  'set constraints all immediate;',
  repairWriteIndex
);
const repairReceiptInsertIndex = preReconciliationRepairSql.indexOf(
  'insert into supabase_migrations.cnyos_migration_ledger_repair_receipts',
  repairFirstSetConstraintsIndex
);
const repairSecondSetConstraintsIndex = preReconciliationRepairSql.indexOf(
  'set constraints all immediate;',
  repairReceiptInsertIndex
);
for (const requiredRepairBoundary of [
  repairSessionLockIndex,
  repairGeneratedCommentIndex,
  repairBeginIndex,
  repairWriteSearchPathIndex,
  repairGuardIndex,
  repairTransactionModeCheckIndex,
  repairSystemIdentityCheckIndex,
  repairLiveAclInventoryBlockerIndex,
  repairNonceCheckIndex,
  repairXidAllocationIndex,
  repairFirstCatalogCheckIndex,
  repairFirstHealthcheckIndex,
  repairMarkerCreateIndex,
  repairWriteIndex,
  repairFirstInsertIndex,
  repairFirstSetConstraintsIndex,
  repairReceiptInsertIndex,
  repairSecondSetConstraintsIndex,
  repairCommittedNonceSetIndex,
  repairCommitIndex,
  repairEvidenceIndex
]) assert.notEqual(requiredRepairBoundary, -1);
assert.equal(
  repairMarkerDropIndex,
  -1,
  'the blocked pre-reconciliation path must not reset a temp marker before its guard'
);
assert.ok(
  repairSessionLockIndex < repairGeneratedCommentIndex &&
  repairGeneratedCommentIndex < repairBeginIndex &&
  repairBeginIndex < repairWriteSearchPathIndex &&
  repairWriteSearchPathIndex < repairGuardIndex &&
  repairGuardIndex < repairTransactionModeCheckIndex &&
  repairTransactionModeCheckIndex < repairSystemIdentityCheckIndex &&
  repairSystemIdentityCheckIndex < repairLiveAclInventoryBlockerIndex &&
  repairLiveAclInventoryBlockerIndex < repairNonceCheckIndex &&
  repairLiveAclInventoryBlockerIndex < repairXidAllocationIndex &&
  repairLiveAclInventoryBlockerIndex < repairFirstCatalogCheckIndex &&
  repairLiveAclInventoryBlockerIndex < repairFirstHealthcheckIndex &&
  repairLiveAclInventoryBlockerIndex < repairMarkerCreateIndex &&
  repairLiveAclInventoryBlockerIndex < repairFirstInsertIndex &&
  repairGuardIndex < repairWriteIndex &&
  repairWriteIndex < repairFirstSetConstraintsIndex &&
  repairFirstSetConstraintsIndex < repairReceiptInsertIndex &&
  repairReceiptInsertIndex < repairSecondSetConstraintsIndex &&
  repairSecondSetConstraintsIndex < repairCommittedNonceSetIndex &&
  repairWriteIndex < repairCommittedNonceSetIndex &&
  repairCommittedNonceSetIndex < repairCommitIndex &&
  repairCommitIndex < repairEvidenceIndex,
  'after transaction/cluster identity checks, the pre-write live ACL blocker must precede nonce use, XID allocation, validation, healthchecks, temp-table DDL, INSERT, writes, and proof'
);
const postCommitRepairProof = preReconciliationRepairSql.slice(repairCommitIndex);
assert.match(
  postCommitRepairProof,
  /^\ncommit;\nbegin isolation level repeatable read read only;\nset local timezone = 'UTC';\nset local datestyle = 'ISO, YMD';\nset local intervalstyle = 'postgres';\nset local extra_float_digits = 3;\nset local bytea_output = 'hex';\nset local quote_all_identifiers = off;\nset local standard_conforming_strings = on;\nset local search_path = pg_catalog, pg_temp, public;\nset local statement_timeout = '60s';\nset local lock_timeout = '5s';\nlock table only supabase_migrations\.schema_migrations in share mode;\nlock table only supabase_migrations\.cnyos_migration_ledger_repair_receipts in share mode;\n/
);
assert.match(
  postCommitRepairProof,
  /select case when count\(\*\)=1 then min\(receipt\.evidence::text\) end as cnyos_repair_evidence[\s\S]*receipt\.repair_xid=coalesce\(current_setting\('cnyos\.migration_ledger_repair_committed_xid',true\),''\)[\s\S]*receipt\.evidence->>'repair_run_nonce'=receipt\.run_nonce::text[\s\S]*receipt\.evidence->>'repair_transaction_xid'=receipt\.repair_xid/
);
assert.match(
  postCommitRepairProof,
  /pg_catalog\.current_database\(\)='postgres'\n    and session_user='postgres'\n    and current_user='postgres'\n    and current_setting\('transaction_read_only'\)='on'\n    and current_setting\('transaction_isolation'\)='repeatable read'/
);
assert.match(
  postCommitRepairProof,
  /receipt\.evidence->>'expected_current_database'='postgres'[\s\S]*receipt\.evidence->>'expected_session_user'='postgres'[\s\S]*receipt\.evidence->>'expected_current_user'='postgres'[\s\S]*receipt\.evidence->>'observed_current_database'='postgres'[\s\S]*receipt\.evidence->>'observed_session_user'='postgres'[\s\S]*receipt\.evidence->>'observed_current_user'='postgres'/
);
assert.match(
  postCommitRepairProof,
  /from supabase_migrations\.cnyos_migration_ledger_repair_receipts receipt/
);
assert.match(
  postCommitRepairProof,
  /from supabase_migrations\.schema_migrations/
);
assert.match(
  postCommitRepairProof,
  /from supabase_migrations\.schema_migrations actual[\s\S]*left join \(values[\s\S]*left join supabase_migrations\.schema_migrations actual/
);
assert.match(
  postCommitRepairProof,
  /\\gset\n\\if :\{\?cnyos_repair_evidence\}\nrollback;\n\\unset cnyos_repair_lock_released\nselect pg_catalog\.pg_advisory_unlock\(202608302100::bigint\) as cnyos_repair_lock_released\n\\gset\n\\if :cnyos_repair_lock_released\n\\unset cnyos_repair_lock_fully_released\nselect not exists \([\s\S]*\) as cnyos_repair_lock_fully_released\n\\gset\n\\if :cnyos_repair_lock_fully_released\nselect :'cnyos_repair_evidence'::jsonb as migration_ledger_evidence;/
);
assert.match(
  postCommitRepairProof,
  /CNYOS_LEDGER_REPAIR_ADVISORY_UNLOCK_FAILED[\s\S]*\\else\nrollback;\n\\unset cnyos_repair_lock_released\nselect pg_catalog\.pg_advisory_unlock\(202608302100::bigint\) as cnyos_repair_lock_released[\s\S]*cnyos_repair_lock_fully_released[\s\S]*CNYOS_LEDGER_REPAIR_COMMIT_PROOF_FAILED/
);

for (const [grantee, procedureSignature] of transitionManifest.browserRpcAclTuples) {
  assert.ok(preReconciliationVerificationSql.includes(`('${procedureSignature}','${grantee}')`));
  assert.ok(preReconciliationRepairSql.includes(`('${procedureSignature}','${grantee}')`));
}

for (const builder of [buildMigrationLedgerVerificationSql, buildMigrationLedgerRepairSql]) {
  for (const deploymentId of [
    'jitarsa-clinical-staging\nselect 1 as cnyos_injected;',
    'jitarsa-clinical-staging\r\n\\echo forged'
  ]) {
    assert.throws(
      () => builder({
        config: { ...jitarsaConfig, deploymentId },
        entries,
        sourceRevision: revision
      }),
      /deploymentId must start with a letter or digit and contain only letters, digits, \., _ or -/
    );
  }
  assert.throws(
    () => builder({
      config: jitarsaConfig,
      entries,
      sourceRevision: revision,
      aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
    }),
    /restricted to the exact reviewed staging target/
  );
  assert.throws(
    () => builder({
      config: cnyosConfig,
      entries,
      sourceRevision: revision,
      aclPhase: 'unreviewed-transition'
    }),
    /Unsupported migration-ledger ACL phase/
  );
  for (const configMutation of [
    { database: { ...cnyosConfig.database, url: 'https://hsmnjwxurlmsizndjlun.evil.example' } },
    { database: { ...cnyosConfig.database, url: 'https://hsmnjwxurlmsizndjlun.supabase.co/rest/v1' } },
    { database: { ...cnyosConfig.database, url: 'https://hsmnjwxurlmsizndjlun.supabase.co?copy=1' } },
    { deploymentId: 'chananya-clinical-staging-copy' },
    {
      tenant: { ...cnyosConfig.tenant, expectedClinicCode: 'CHANANYA-STAGING' },
      identity: { ...cnyosConfig.identity, qrIssuer: 'CHANANYA-STAGING' }
    },
    { tenant: { ...cnyosConfig.tenant, expectedClinicId: '00000000-0000-4000-8000-00000000a002' } }
  ]) {
    assert.throws(
      () => builder({
        config: { ...cnyosConfig, ...configMutation },
        entries,
        sourceRevision: revision,
        aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
      }),
      /restricted to the exact reviewed staging target|tenant\.expectedClinicId/
    );
  }
}
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: cnyosConfig,
    entries,
    sourceRevision: '79750ef',
    aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
  }),
  /full 40-character artifact source revision/
);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: cnyosConfig,
    entries,
    aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
  }),
  /full 40-character artifact source revision/
);
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: jitarsaConfig,
    entries,
    sourceRevision: revision,
    aclPhase: MIGRATION_LEDGER_ACL_PHASE_STRICT
  }),
  /restricted to the exact reviewed Chananya staging target/
);
const equalCardinalityManifestSwap = entries.map(entry => ({ ...entry }));
[
  equalCardinalityManifestSwap[0].sha256,
  equalCardinalityManifestSwap[1].sha256
] = [
  equalCardinalityManifestSwap[1].sha256,
  equalCardinalityManifestSwap[0].sha256
];
assert.throws(
  () => buildMigrationLedgerRepairSql({
    config: cnyosConfig,
    entries: equalCardinalityManifestSwap,
    sourceRevision: revision,
    aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
  }),
  /exact reviewed 45-entry migration manifest/
);
for (const config of [cnyosConfig, jitarsaConfig]) {
  assert.throws(
    () => buildMigrationLedgerVerificationSql({
      config,
      entries: equalCardinalityManifestSwap,
      sourceRevision: revision
    }),
    /exact reviewed 45-entry migration manifest/,
    'read-only verification must reject an equal-cardinality manifest swap'
  );
}
const canonicalLookingManifestMutations = [
  [
    ...entries,
    {
      version: '202609011400',
      name: 'unreviewed_canonical_looking_addition',
      file: '202609011400_unreviewed_canonical_looking_addition.sql',
      sha256: '1'.repeat(64)
    }
  ],
  entries.map((entry, index) => {
    if (index === entries.length - 1) return { ...entry, sha256: '2'.repeat(64) };
    return { ...entry };
  }),
  [
    ...entries.slice(0, -2),
    { ...entries.at(-1) },
    { ...entries.at(-2) }
  ]
];
for (const mutatedEntries of canonicalLookingManifestMutations) {
  for (const aclPhase of [
    undefined,
    MIGRATION_LEDGER_ACL_PHASE_STRICT,
    MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
  ]) {
    assert.throws(
      () => buildMigrationLedgerRepairSql({
        config: cnyosConfig,
        entries: mutatedEntries,
        sourceRevision: revision,
        ...(aclPhase === undefined ? {} : { aclPhase })
      }),
      /exact reviewed 45-entry migration manifest|strict canonical order/,
      `write-capable ${aclPhase ?? 'default'} repair must reject manifest drift`
    );
  }
  for (const config of [cnyosConfig, jitarsaConfig]) {
    assert.throws(
      () => buildMigrationLedgerVerificationSql({
        config,
        entries: mutatedEntries,
        sourceRevision: revision
      }),
      /exact reviewed 45-entry migration manifest|strict canonical order/,
      'strict read-only verification must reject manifest drift'
    );
  }
  assert.throws(
    () => buildMigrationLedgerVerificationSql({
      config: cnyosConfig,
      entries: mutatedEntries,
      sourceRevision: revision,
      aclPhase: MIGRATION_LEDGER_ACL_PHASE_CHANANYA_PRE_RECONCILIATION
    }),
    /exact reviewed 45-entry migration manifest|strict canonical order/,
    'Chananya pre-reconciliation verification must reject manifest drift'
  );
}

const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const workflowLogicalCommands = workflow.replace(/[ \t]*\\\r?\n[ \t]*/g, ' ');
const executableWorkflowCommands = workflowLogicalCommands
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));
const directRepairGeneratorInvocations = executableWorkflowCommands.filter(line =>
  line.includes('node scripts/generate-migration-ledger-repair-sql.mjs')
);
assert.deepEqual(directRepairGeneratorInvocations, [
  'CLINICAL_OS_SOURCE_COMMIT="${CNYOS_RELEASE_SHA}" node ' +
    'scripts/generate-migration-ledger-repair-sql.mjs ' +
    'config/tenant.cnyos-staging.json chananya-pre-reconciliation ' +
    '> artifacts/migration-ledger/cnyos-staging-pre-reconciliation-guarded-repair.sql'
]);
assert.equal((workflow.match(/migration:ledger-repair-sql/g) ?? []).length, 0);
for (const command of executableWorkflowCommands.filter(line => /jitarsa/i.test(line))) {
  assert.doesNotMatch(command, /repair/i);
}
assert.doesNotMatch(
  workflow,
  /artifacts\/migration-ledger\/jitarsa[^\s]*repair[^\s]*\.sql/i
);
assert.doesNotMatch(
  workflow,
  /artifacts\/migration-ledger\/jitarsa[^\s]*verification[^\s]*\.sql/i
);
const expectedGeneratedSqlArtifacts = [
  'cnyos-staging-strict-post-remediation-verification-only.sql',
  'cnyos-staging-pre-reconciliation-verification-only.sql',
  'cnyos-staging-pre-reconciliation-guarded-repair.sql'
];
const generatedSqlArtifacts = [...workflowLogicalCommands.matchAll(
  />[ \t]*artifacts\/migration-ledger\/([^\s]+\.sql)/g
)].map(([, artifact]) => artifact).sort();
assert.deepEqual(generatedSqlArtifacts, [...expectedGeneratedSqlArtifacts].sort());
assert.doesNotMatch(workflow, /jitarsa-staging-pre-reconciliation/);
assert.equal(MIGRATION_LEDGER_ACL_PHASE_STRICT, 'strict-post-remediation');

console.log(
  'Migration ledger verification contract passed: every mode remains non-authorizing, ' +
  'unverified targets are labeled, and PostgreSQL read-only rollback fails closed'
);
