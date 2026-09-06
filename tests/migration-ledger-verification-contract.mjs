import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  buildMigrationLedgerVerificationSql,
  verificationNoticePrefix
} from '../scripts/generate-migration-ledger-verification-sql.mjs';
import {
  loadMigrationEntries
} from '../scripts/generate-migration-ledger-repair-sql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = loadMigrationEntries(root);
const revision = '2ebadf8f029da9febcba24b8335fd1c0275be964';

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

  assert.match(sql, /^-- Generated read-only staging schema verification\./);
  assert.match(sql, /begin isolation level repeatable read read only;/);
  assert.match(sql, /perform pg_catalog\.pg_advisory_xact_lock\(202608302100::bigint\)/);
  assert.match(sql, /do \$ledger_guard\$/);
  assert.match(sql, /end\n\$ledger_guard\$;\nrollback;/);
  assert.match(sql, /raise notice '%', 'CNYOS_STAGING_SCHEMA_GUARD_PASSED /);
  assert.ok(sql.includes(`"deployment_id":"${config.deploymentId}"`));
  assert.ok(sql.includes(`"clinic_code":"${config.tenant.expectedClinicCode}"`));
  assert.ok(sql.includes('"migration_count":45'));
  assert.ok(sql.includes(`"source_revision":"${revision}"`));
  assert.ok(sql.includes('"rollback_required":true'));
  assert.doesNotMatch(sql, /CNYOS_STAGING_SCHEMA_FINGERPRINT_VERIFIED/);
  assert.doesNotMatch(sql, /from public\.\w+_healthcheck\(\)/);
  assert.doesNotMatch(sql, /perform set_config\('request\.jwt/);

  assert.doesNotMatch(sql, /create schema if not exists supabase_migrations/i);
  assert.doesNotMatch(sql, /insert into supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(sql, /comment on table supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(sql, /\ncommit;\n/i);
  assert.match(sql, /\$ledger_guard\$;\nrollback;\n$/);
  assert.throws(() => buildMigrationLedgerVerificationSql({ config, entries }), /40-character/);
  assert.throws(() => buildMigrationLedgerVerificationSql({ config, entries, sourceRevision: 'abcdef0' }), /40-character/);

  const db = new PGlite();
  try {
    const notices = [];
    const options = { onNotice: notice => notices.push(notice.message) };
    // A blank database must fail before the provisional success notice.
    await assert.rejects(db.exec(sql, options), /STAGING_SCHEMA_RELATIONS_MISSING/);
    await db.exec('rollback;', options);
    assert.ok(!notices.some(message => message.startsWith(verificationNoticePrefix)));

    const guardStart = sql.indexOf('do $ledger_guard$');
    const guardEnd = sql.indexOf('end\n$ledger_guard$;\n') + 'end\n$ledger_guard$;\n'.length;
    const prefix = sql.slice(0, guardStart);
    const guard = sql.slice(guardStart, guardEnd);
    const suffix = sql.slice(guardEnd);
    assert.equal(suffix, 'rollback;\n');

    // Model a client that continues after an error, including one that uses
    // a savepoint to recover the failed statement (psql ON_ERROR_ROLLBACK).
    for (const useSavepoint of [false, true]) {
      notices.length = 0;
      await db.exec(prefix, options);
      if (useSavepoint) await db.exec('savepoint client_statement;', options);
      await assert.rejects(db.exec(guard, options), /STAGING_SCHEMA_RELATIONS_MISSING/);
      if (useSavepoint) await db.exec('rollback to savepoint client_statement;', options);
      await db.exec(suffix, options);
      assert.ok(!notices.some(message => message.startsWith(verificationNoticePrefix)));
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
    assert.ok(!notices.some(message => message.startsWith(verificationNoticePrefix)));

    // Catalog verification must not evaluate drifted RLS policies as its reader.
    await db.exec('create role unprivileged_verifier; set role unprivileged_verifier;');
    await assert.rejects(db.exec(sql, options), /STAGING_VERIFICATION_CATALOG_READER_REQUIRED/);
    await db.exec('rollback; reset role;');
    assert.ok(!notices.some(message => message.startsWith(verificationNoticePrefix)));
  } finally {
    await db.close();
  }
}

console.log('Migration ledger verification contract passed: PostgreSQL rejects drift without success notices, continue-on-error cannot report success, and read-only execution blocks rows and sequences');
